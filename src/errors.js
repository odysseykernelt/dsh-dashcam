'use strict';

/** 契约输入错误：用于 manifest、scope、grant 的格式校验。 */
class CovenantInputError extends Error {
  constructor(message, { code = 'COVENANT_INPUT_INVALID', field = null, file = null, line = null } = {}) {
    super(message);
    this.name = 'CovenantInputError';
    this.code = code;
    this.field = field;
    this.file = file;
    this.line = line;
  }
}

/** 运行时拒绝：由守卫链抛出，携带原始拒绝原因。 */
class CovenantDenied extends Error {
  constructor(reason, { capability = null, scope = null, ruleId = 'two-key', ledgerSeq = null } = {}) {
    super(reason);
    this.name = 'CovenantDenied';
    this.code = 'COVENANT_DENIED';
    this.reason = reason;
    this.capability = capability;
    this.scope = scope;
    this.ruleId = ruleId;
    this.ledgerSeq = ledgerSeq;
  }
}

/** 门禁失败：统一错误结构，精确到字段与文件行。 */
function gateError(gate, code, message, { field = null, file = null, line = null, phase = null, item = null } = {}) {
  return { gate, code, message, field, file, line, phase, item };
}

module.exports = { CovenantInputError, CovenantDenied, gateError };
