<template>
  <div class="audit">
    <h2>智能合约安全审计</h2>
    <div class="upload-section">
      <textarea v-model="contractCode" class="code-editor" placeholder="// 粘贴 Solidity 合约代码..."></textarea>
      <div class="toolbar">
        <input v-model="filename" placeholder="文件名.sol" class="filename-input" />
        <button @click="runAudit" class="btn-primary" :disabled="!contractCode || isAuditing">
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
        <div v-for="v in result.vulnerabilities" :key="v.line + v.type" class="vuln-card" :class="v.severity">
          <div class="vuln-header">
            <span class="vuln-type">{{ v.type }}</span>
            <span class="vuln-severity">{{ v.severity }}</span>
          </div>
          <div class="vuln-desc">{{ v.description }}</div>
          <div class="vuln-suggest">建议: {{ v.suggestion }}</div>
        </div>
      </div>

      <div v-if="evaluation" class="budget-section">
        <h3>Gas 预算检查</h3>
        <div v-if="rejectedLimits.length" class="rejected-card">
          <div class="rejected-title">已拦截 {{ rejectedLimits.length }} 条非法阈值（其余合法条目仍生效）：</div>
          <div v-for="r in rejectedLimits" :key="r.target" class="rejected-item">
            <code>{{ r.target }}</code> = {{ r.value }} — {{ r.reason }}
          </div>
        </div>
        <div v-if="evaluation.exceeded.length" class="budget-group">
          <div class="budget-group-title exceeded-title">超出预算 ({{ evaluation.exceeded.length }})</div>
          <div v-for="e in evaluation.exceeded" :key="e.functionName" class="budget-card exceeded">
            <div class="budget-head">
              <span class="budget-fn">{{ e.functionName }}</span>
              <span class="budget-tag tag-exceeded">超标 {{ e.exceedRatio }}%</span>
            </div>
            <div class="budget-line">估算 {{ e.estimatedGas.toLocaleString() }} gas / 上限 {{ e.limit?.toLocaleString() }} gas（{{ e.limitSource === 'function' ? '单独阈值' : '默认上限' }}）</div>
            <div class="budget-reason">{{ e.reason }}</div>
          </div>
        </div>
        <div v-if="evaluation.warnings.length" class="budget-group">
          <div class="budget-group-title warning-title">接近阈值 ({{ evaluation.warnings.length }})</div>
          <div v-for="e in evaluation.warnings" :key="e.functionName" class="budget-card warning">
            <div class="budget-head">
              <span class="budget-fn">{{ e.functionName }}</span>
              <span class="budget-tag tag-warning">提醒</span>
            </div>
            <div class="budget-line">估算 {{ e.estimatedGas.toLocaleString() }} gas，已达上限（{{ e.limit?.toLocaleString() }} gas）的 {{ Math.round((e.ratio ?? 0) * 100) }}%</div>
          </div>
        </div>
        <div v-if="evaluation.noData.length" class="budget-group">
          <div class="budget-group-title nodata-title">未采集到消耗数据 ({{ evaluation.noData.length }})</div>
          <div v-for="n in evaluation.noData" :key="n.functionName + n.line" class="budget-card nodata">
            <div class="budget-head">
              <span class="budget-fn">{{ n.functionName }}</span>
              <span class="budget-tag tag-nodata">无数据</span>
            </div>
            <div class="budget-line">{{ n.reason }}</div>
          </div>
        </div>
        <div v-if="allOk" class="budget-ok">
          {{ measuredCount }} 个函数均在 Gas 预算内
        </div>
        <div class="budget-hint">可在 <router-link to="/gas">Gas 分析页</router-link> 调整默认上限或为单个函数设定阈值</div>
      </div>

      <div v-if="result.gasIssues.length > 0" class="gas-section">
        <h3>Gas优化建议</h3>
        <div v-for="g in result.gasIssues" :key="g.functionName" class="gas-card">
          <div class="gas-fn">{{ g.functionName }}</div>
          <div class="gas-info">当前: {{ g.currentGas }} → 优化后: {{ g.optimizedGas }} ({{ Math.round((1-g.optimizedGas/g.currentGas)*100) }}%节省)</div>
          <div class="gas-suggest">{{ g.suggestion }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import { useAuditStore } from "@/store"

const store = useAuditStore()

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
}`)
const filename = ref("SimpleBank.sol")
const isAuditing = ref(false)

const result = computed(() => store.currentResult)
const evaluation = computed(() => store.budgetEvaluation)
const rejectedLimits = computed(() => store.budgetRejected)
const measuredCount = computed(() => evaluation.value?.entries.length ?? 0)
const allOk = computed(() => {
  const entries = evaluation.value?.entries ?? []
  return entries.length > 0 && entries.every((e) => e.status === "ok")
})

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

async function runAudit() {
  isAuditing.value = true
  try {
    await store.runAudit(contractCode.value, filename.value)
  } finally {
    isAuditing.value = false
  }
}
</script>

<style scoped>
.audit { max-width: 1000px; }
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
.vulnerabilities h3, .gas-section h3, .budget-section h3 { margin-bottom: 1rem; font-size: 1.125rem; }
.vuln-card { background: white; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; border-left: 4px solid; }
.vuln-card.critical { border-color: #dc2626; }
.vuln-card.high { border-color: #f59e0b; }
.vuln-card.medium { border-color: #3b82f6; }
.vuln-card.low { border-color: #6b7280; }
.vuln-header { display: flex; justify-content: space-between; margin-bottom: 0.75rem; }
.vuln-type { font-weight: 600; }
.vuln-severity { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; background: #fee2e2; color: #dc2626; }
.vuln-desc { color: #374151; margin-bottom: 0.5rem; }
.vuln-suggest { font-size: 0.875rem; color: #6b7280; }
.gas-card { background: white; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
.gas-fn { font-weight: 600; color: #7c3aed; margin-bottom: 0.5rem; }
.gas-info { color: #059669; font-size: 0.875rem; margin-bottom: 0.5rem; }
.gas-suggest { font-size: 0.875rem; color: #6b7280; }

.budget-section { margin-bottom: 2rem; }
.budget-group { margin-bottom: 1rem; }
.budget-group-title { font-weight: 600; font-size: 0.9375rem; margin-bottom: 0.5rem; }
.exceeded-title { color: #dc2626; }
.warning-title { color: #d97706; }
.nodata-title { color: #6b7280; }
.budget-card { background: white; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; border-left: 4px solid; }
.budget-card.exceeded { border-color: #dc2626; }
.budget-card.warning { border-color: #f59e0b; }
.budget-card.nodata { border-color: #9ca3af; }
.budget-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.375rem; }
.budget-fn { font-weight: 600; color: #7c3aed; }
.budget-tag { padding: 0.125rem 0.625rem; border-radius: 9999px; font-size: 0.75rem; }
.tag-exceeded { background: #fee2e2; color: #dc2626; }
.tag-warning { background: #fef3c7; color: #d97706; }
.tag-nodata { background: #f3f4f6; color: #6b7280; }
.budget-line { font-size: 0.875rem; color: #374151; margin-bottom: 0.25rem; }
.budget-reason { font-size: 0.875rem; color: #6b7280; }
.budget-ok { background: #d1fae5; color: #065f46; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }
.rejected-card { background: #fff7ed; border: 1px solid #fdba74; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
.rejected-title { font-weight: 600; color: #c2410c; font-size: 0.875rem; margin-bottom: 0.5rem; }
.rejected-item { font-size: 0.8125rem; color: #7c2d12; margin-bottom: 0.25rem; }
.rejected-item code { background: #ffedd5; padding: 0.0625rem 0.375rem; border-radius: 4px; }
.budget-hint { font-size: 0.8125rem; color: #6b7280; }
.budget-hint a { color: #7c3aed; }
</style>
