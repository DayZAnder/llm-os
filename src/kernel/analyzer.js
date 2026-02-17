// Static analysis for LLM-generated code
// Regex-based, deterministic, no LLM in the loop

const RULES = [
  {
    id: 'EVAL_USAGE',
    severity: 'CRITICAL',
    description: 'Use of eval() or Function() constructor',
    pattern: /\b(?:eval|Function)\s*\(/g,
  },
  {
    id: 'DYNAMIC_IMPORT',
    severity: 'CRITICAL',
    description: 'Dynamic import() expression',
    pattern: /\bimport\s*\(/g,
  },
  {
    id: 'PARENT_ACCESS',
    severity: 'CRITICAL',
    description: 'Attempt to access parent frame or top window',
    pattern: /\b(?:window\.parent|window\.top|parent\.|top\.(?!margin|padding|border))\b/g,
  },
  {
    id: 'DOCUMENT_COOKIE',
    severity: 'CRITICAL',
    description: 'Attempt to access cookies',
    pattern: /document\.cookie/g,
  },
  {
    id: 'RAW_FETCH',
    severity: 'WARNING',
    description: 'Direct fetch/XHR/WebSocket (should use LLMOS.net)',
    pattern: /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/g,
  },
  {
    id: 'SETTIMEOUT_STRING',
    severity: 'CRITICAL',
    description: 'setTimeout/setInterval with string argument (implicit eval)',
    pattern: /(?:setTimeout|setInterval)\s*\(\s*['"]/g,
  },
  {
    id: 'ENCODED_PAYLOAD',
    severity: 'WARNING',
    description: 'Base64-encoded or String.fromCharCode content',
    pattern: /(?:atob|btoa|String\.fromCharCode)\s*\(/g,
  },
  {
    id: 'PROTOTYPE_POLLUTION',
    severity: 'CRITICAL',
    description: 'Prototype pollution attempt',
    pattern: /(?:__proto__|constructor\s*\.\s*prototype)/g,
  },
  {
    id: 'GLOBAL_OVERRIDE',
    severity: 'CRITICAL',
    description: 'Attempt to override global objects',
    pattern: /\b(?:globalThis|self)\s*[.[=]/g,
  },
  {
    id: 'INLINE_EVENT_HANDLER',
    severity: 'WARNING',
    description: 'Inline event handlers can execute arbitrary code',
    pattern: /\bon(?:error|load|click|mouse\w+)\s*=\s*["'][^"']*(?:eval|Function|import)\b/gi,
  },
];

export function analyze(code) {
  const findings = [];
  const lines = code.split('\n');

  for (const rule of RULES) {
    // Reset regex state
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(code)) !== null) {
      // Find line number
      const beforeMatch = code.slice(0, match.index);
      const lineNum = beforeMatch.split('\n').length;
      const lineContent = lines[lineNum - 1] || '';

      // Skip if it's inside the capabilities comment
      if (lineContent.trim().startsWith('<!--') && lineContent.includes('capabilities')) continue;

      // Skip if it's inside the SDK script itself (we inject it)
      if (lineContent.includes('// LLM-OS SDK')) continue;

      findings.push({
        rule: rule.id,
        severity: rule.severity,
        description: rule.description,
        line: lineNum,
        snippet: lineContent.trim().slice(0, 120),
      });
    }

    rule.pattern.lastIndex = 0;
  }

  const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;

  return {
    passed: criticalCount === 0,
    criticalCount,
    warningCount: findings.filter(f => f.severity === 'WARNING').length,
    findings,
  };
}
