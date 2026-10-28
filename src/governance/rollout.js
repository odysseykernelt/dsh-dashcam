'use strict';

const STAGES = Object.freeze([
  'contract-two-key',
  'bridge-ledger',
  'structure-signature',
  'safety-loadability',
  'portrait-autopsy',
  'charter-sieve',
]);

const DEFAULT_THRESHOLDS = Object.freeze({
  falseKillRate: 0.02,
  abandonmentRate: 0.05,
  silentFailureRate: 0.01,
});

/** 熔断判定：任一指标超阈值即返回违例，调用方必须回退上一档。 */
function checkCircuitBreaker(metrics = {}, thresholds = DEFAULT_THRESHOLDS) {
  const violations = [];
  if (metrics.falseKillRate > thresholds.falseKillRate) {
    violations.push({
      metric: 'falseKillRate',
      value: metrics.falseKillRate,
      threshold: thresholds.falseKillRate,
      action: 'rollback',
    });
  }
  if (metrics.abandonmentRate > thresholds.abandonmentRate) {
    violations.push({
      metric: 'abandonmentRate',
      value: metrics.abandonmentRate,
      threshold: thresholds.abandonmentRate,
      action: 'rollback',
    });
  }
  if (metrics.silentFailureRate > thresholds.silentFailureRate) {
    violations.push({
      metric: 'silentFailureRate',
      value: metrics.silentFailureRate,
      threshold: thresholds.silentFailureRate,
      action: 'rollback',
    });
  }
  return { ok: violations.length === 0, violations };
}

class RolloutController {
  constructor({ stageIndex = 0, thresholds = DEFAULT_THRESHOLDS, autoAdvance = false } = {}) {
    if (stageIndex < 0 || stageIndex >= STAGES.length) throw new Error('stageIndex 越界');
    this.stageIndex = stageIndex;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.autoAdvance = autoAdvance;
  }

  get stage() {
    return STAGES[this.stageIndex];
  }

  evaluate(metrics) {
    const check = checkCircuitBreaker(metrics, this.thresholds);
    if (!check.ok) {
      const from = this.stage;
      this.stageIndex = Math.max(0, this.stageIndex - 1);
      return {
        action: 'rollback',
        from,
        to: this.stage,
        stageIndex: this.stageIndex,
        violations: check.violations,
      };
    }
    if (this.autoAdvance && this.stageIndex < STAGES.length - 1) {
      const from = this.stage;
      this.stageIndex += 1;
      return { action: 'advance', from, to: this.stage, stageIndex: this.stageIndex, violations: [] };
    }
    return { action: 'hold', stage: this.stage, stageIndex: this.stageIndex, violations: [] };
  }

  advance() {
    if (this.stageIndex >= STAGES.length - 1) return this.stage;
    this.stageIndex += 1;
    return this.stage;
  }
}

module.exports = { STAGES, DEFAULT_THRESHOLDS, checkCircuitBreaker, RolloutController };
