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
  {
    id: 'TEMPLATE_LITERAL_EVAL',
    severity: 'CRITICAL',
    description: 'Template literal used for code execution bypass',
    pattern: /(?:eval|Function)\s*`/g,
  },
  {
    id: 'INDIRECT_EVAL',
    severity: 'CRITICAL',
    description: 'Indirect eval via aliasing or bracket access',
    pattern: /(?:\(0,\s*eval\)|window\s*\[\s*['"]eval['"]\s*\]|this\s*\[\s*['"]eval['"]\s*\])/g,
  },
  {
    id: 'PROXY_REFLECT_ABUSE',
    severity: 'WARNING',
    description: 'Proxy/Reflect can intercept SDK internals',
    pattern: /\bnew\s+Proxy\s*\(|Reflect\s*\.\s*(?:apply|construct|get|set)\s*\(/g,
  },
  {
    id: 'CSS_EXFILTRATION',
    severity: 'WARNING',
    description: 'CSS-based data exfiltration via url() or @import',
    pattern: /(?:url\s*\(\s*['"]?https?:|@import\s+['"]?https?:)/gi,
  },
  {
    id: 'SVG_SCRIPT',
    severity: 'CRITICAL',
    description: 'SVG can embed script elements for code execution',
    pattern: /<svg[\s>][\s\S]*?<script/gi,
  },
  {
    id: 'IFRAME_INJECTION',
    severity: 'CRITICAL',
    description: 'Nested iframe creation can bypass sandbox',
    pattern: /(?:createElement\s*\(\s*['"]iframe['"]\)|<iframe[\s>])/gi,
  },
  {
    id: 'SERVICE_WORKER',
    severity: 'CRITICAL',
    description: 'Service worker registration can persist malicious code',
    pattern: /navigator\s*\.\s*serviceWorker/g,
  },
  // --- Phase 2 rules: catch obfuscation & advanced escape vectors ---
  {
    id: 'BRACKET_EVAL',
    severity: 'CRITICAL',
    description: 'Bracket notation to access eval/Function/constructor',
    // Catches: window["eval"], obj["constructor"], this["Function"]
    pattern: /\[\s*['"](?:eval|Function|constructor|__proto__)['"]\s*\]/g,
  },
  {
    id: 'COMPUTED_PROPERTY_EXEC',
    severity: 'WARNING',
    description: 'Computed property access on window/document (potential obfuscation)',
    // Catches: window[varName], document[x], globalThis[y]
    pattern: /\b(?:window|document|globalThis|self)\s*\[\s*[a-zA-Z_$]/g,
  },
  {
    id: 'STRING_CONCAT_EVAL',
    severity: 'CRITICAL',
    description: 'String concatenation to build eval/Function calls',
    // Catches: "ev"+"al", "Func"+"tion"
    pattern: /['"]ev['"]\s*\+\s*['"]al['"]|['"]Func['"]\s*\+\s*['"]tion['"]/g,
  },
  {
    id: 'DOCUMENT_WRITE',
    severity: 'CRITICAL',
    description: 'document.write can inject arbitrary HTML/scripts',
    pattern: /document\s*\.\s*write(?:ln)?\s*\(/g,
  },
  {
    id: 'INNER_HTML_ASSIGN',
    severity: 'WARNING',
    description: 'innerHTML/outerHTML assignment can inject scripts',
    pattern: /\.(?:innerHTML|outerHTML)\s*[+]?=/g,
  },
  {
    id: 'BLOB_URL',
    severity: 'WARNING',
    description: 'Blob URLs can bypass CSP and load arbitrary code',
    pattern: /URL\s*\.\s*createObjectURL\s*\(/g,
  },
  {
    id: 'SHARED_ARRAY_BUFFER',
    severity: 'CRITICAL',
    description: 'SharedArrayBuffer enables timing attacks and Spectre exploits',
    pattern: /\bSharedArrayBuffer\b/g,
  },
  {
    id: 'WEB_RTC',
    severity: 'WARNING',
    description: 'WebRTC can leak local IP and enable fingerprinting',
    pattern: /\bRTCPeerConnection\b|\bRTCDataChannel\b/g,
  },
  {
    id: 'IMPORT_SCRIPTS',
    severity: 'CRITICAL',
    description: 'importScripts loads external code in workers',
    pattern: /\bimportScripts\s*\(/g,
  },
  {
    id: 'LOCATION_ASSIGN',
    severity: 'CRITICAL',
    description: 'Redirect or navigation can escape the sandbox',
    pattern: /(?:location\s*\.\s*href\s*=|location\s*\.\s*(?:assign|replace)\s*\(|location\s*=\s*['"`])/g,
  },
  {
    id: 'POSTMESSAGE_WILDCARD',
    severity: 'WARNING',
    description: 'postMessage with wildcard origin bypasses origin checks',
    pattern: /\.postMessage\s*\([^)]*,\s*['"]\*['"]\s*\)/g,
  },
  {
    id: 'CHAR_CODE_OBFUSCATION',
    severity: 'WARNING',
    description: 'Character code manipulation to hide malicious strings',
    // Catches chained fromCharCode or charCodeAt patterns
    pattern: /(?:fromCharCode|charCodeAt)\s*\([^)]*\)(?:\s*\+\s*.*(?:fromCharCode|charCodeAt))+/g,
  },
  {
    id: 'MUTATION_OBSERVER_ABUSE',
    severity: 'WARNING',
    description: 'MutationObserver can monitor and manipulate the sandbox DOM',
    pattern: /\bnew\s+MutationObserver\s*\(/g,
  },
  // --- Phase 3 rules: found by LLM-generated adversarial vectors ---
  {
    id: 'IMAGE_EXFILTRATION',
    severity: 'CRITICAL',
    description: 'Image src can exfiltrate data to external server',
    pattern: /new\s+Image\s*\(\s*\)\s*\.\s*src\s*=/g,
  },
  {
    id: 'SEND_BEACON',
    severity: 'CRITICAL',
    description: 'navigator.sendBeacon sends data without visible network request',
    pattern: /navigator\s*\.\s*sendBeacon\s*\(/g,
  },
  {
    id: 'CONTENT_WINDOW',
    severity: 'CRITICAL',
    description: 'contentWindow/contentDocument access can escape iframe sandbox',
    pattern: /\.(?:contentWindow|contentDocument|ownerDocument\s*\.\s*defaultView)\b/g,
  },
  {
    id: 'FRAME_ELEMENT',
    severity: 'CRITICAL',
    description: 'frameElement access can traverse frame boundaries',
    pattern: /\bframeElement\b/g,
  },
  {
    id: 'DNS_PREFETCH_EXFIL',
    severity: 'WARNING',
    description: 'DNS prefetch/preconnect can leak data via domain names',
    pattern: /(?:dns-prefetch|preconnect).*?href\s*=|rel\s*=\s*['"](?:dns-prefetch|preconnect)['"]/gi,
  },
];

// Dockerfile-specific rules (used by analyzeDockerfile)
const DOCKERFILE_RULES = [
  {
    id: 'DOCKERFILE_PRIVILEGED',
    severity: 'CRITICAL',
    description: 'Privileged container grants full host access',
    pattern: /--privileged/g,
  },
  {
    id: 'DOCKERFILE_HOST_NETWORK',
    severity: 'CRITICAL',
    description: 'Host network mode bypasses container isolation',
    pattern: /--network[= ]host/g,
  },
  {
    id: 'DOCKERFILE_VOLUME_ROOT',
    severity: 'CRITICAL',
    description: 'Mounting root filesystem exposes entire host',
    pattern: /(?:VOLUME|--volume|-v)\s+[^\s]*:?\s*\/(?:\s|$)/g,
  },
  {
    id: 'DOCKERFILE_LATEST_TAG',
    severity: 'WARNING',
    description: 'Unpinned :latest tag may introduce breaking changes',
    pattern: /FROM\s+\S+:latest/gi,
  },
];

function runRules(code, rules, skipLine = () => false) {
  const findings = [];
  const lines = code.split('\n');

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(code)) !== null) {
      const beforeMatch = code.slice(0, match.index);
      const lineNum = beforeMatch.split('\n').length;
      const lineContent = lines[lineNum - 1] || '';
      const trimmed = lineContent.trim();

      if (skipLine(trimmed)) continue;

      findings.push({
        rule: rule.id,
        severity: rule.severity,
        description: rule.description,
        line: lineNum,
        snippet: trimmed.slice(0, 120),
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

export function analyze(code) {
  return runRules(code, RULES, line =>
    (line.startsWith('<!--') && line.includes('capabilities')) ||
    line.includes('// LLM-OS SDK')
  );
}

export function analyzeDockerfile(content) {
  return runRules(content, DOCKERFILE_RULES, line => line.startsWith('#'));
}
