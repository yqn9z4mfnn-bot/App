import { formatFetchError, isTransientFetchError } from '../lib/transient-fetch.mjs';

const cases = [
  [new Error('fetch failed'), true, 'Falha de rede no proxy'],
  [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), true, 'Falha de rede no proxy'],
  [Object.assign(new Error('request aborted'), { name: 'AbortError' }), true, 'Timeout na API (proxy/rede)'],
  [new Error('Timeout na API Claro'), true, 'Timeout na API (proxy/rede)'],
  [new Error('Falha no login (401): nope'), false, 'Falha no login (401): nope'],
];

let failed = 0;
for (const [err, transient, label] of cases) {
  if (isTransientFetchError(err) !== transient) {
    failed += 1;
    console.error('FAIL transient', err.message, { expected: transient, got: isTransientFetchError(err) });
  }
  if (formatFetchError(err) !== label) {
    failed += 1;
    console.error('FAIL format', err.message, { expected: label, got: formatFetchError(err) });
  }
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok', cases.length, 'casos');
