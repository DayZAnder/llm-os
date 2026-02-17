// Self-Improvement Task Registry
// Exports all task definitions for the scheduler.

import { definition as generateApps } from './generate-apps.js';
import { definition as testSecurity } from './test-security.js';
import { definition as improveApps } from './improve-apps.js';
import { definition as qcApps } from './qc-apps.js';

export const tasks = [
  generateApps,
  testSecurity,
  improveApps,
  qcApps,
];
