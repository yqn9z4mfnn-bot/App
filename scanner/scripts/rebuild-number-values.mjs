#!/usr/bin/env node
/** Reconstrói number_values a partir de numbers.valores (corrige /valores desatualizado). */
import '../lib/load-env.mjs';
import { rebuildValueIndex, countNumbers, countWithValues } from '../lib/numbers-db.mjs';

const before = countWithValues();
const okRows = rebuildValueIndex();
const after = countWithValues();
console.log(`Rebuild: ${okRows} logins ok · índice ${before} → ${after} msisdn com valor · banco ok=${countNumbers({ onlyOk: true })}`);
