import type { AuditResult, GasBudgetConfig, Vulnerability } from '@/types'
import { analyzeContractGas } from './gasAnalysis'
import { evaluateGasBudget, validateGasBudgetConfig } from './gasBudget'

/**
 * 后端不可用时的本地兜底审计。
 * 漏洞检测规则与原先 AuditView 中的客户端检查保持一致，
 * Gas 估算与预算评估使用和前端共享模块相同的确定性规则。
 */
export function runLocalAudit(code: string, filename: string, budgetConfig: Partial<GasBudgetConfig>): AuditResult {
  const vulns: Vulnerability[] = []
  if (code.includes('msg.sender.call')) {
    vulns.push({
      type: '重入攻击 (Reentrancy)',
      severity: 'critical',
      line: code.split('\n').findIndex((l) => l.includes('msg.sender.call')) + 1,
      description: '使用了低级的 call() 接收ETH，存在重入攻击风险。攻击者可部署恶意合约在fallback中反复调用提款。',
      suggestion: '使用 Checks-Effects-Interactions 模式，或使用 ReentrancyGuard 修饰符。',
    })
  }
  if (code.includes('require(balances')) {
    vulns.push({
      type: '整数溢出 (Integer Overflow)',
      severity: 'high',
      line: 1,
      description: 'Solidity 0.8以下版本未启用溢出检查，需注意。',
      suggestion: '使用 SafeMath 库或在 Solidity 0.8+ 环境中编译。',
    })
  }

  const { measurements, noData, gasIssues } = analyzeContractGas(code)
  const { valid, rejected } = validateGasBudgetConfig(budgetConfig)
  const budget = evaluateGasBudget(measurements, noData, valid)
  budget.rejected = rejected

  return {
    id: `local-${Date.now()}`,
    filename,
    score: vulns.length === 0 ? 95 : Math.max(20, 85 - vulns.length * 25),
    vulnerabilities: vulns,
    gasIssues,
    gasMeasurements: measurements,
    gasNoData: noData,
    gasBudget: budget,
    timestamp: new Date().toISOString(),
  }
}
