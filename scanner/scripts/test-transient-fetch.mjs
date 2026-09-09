import { formatFetchError, isTransientFetchError } from '../lib/transient-fetch.mjs';

const proxyOff = process.env.PROXY_ENABLED;
process.env.PROXY_ENABLED = '0';

const cases = [
  [new Error('fetch failed'), true, 'Falha de rede na API'],
  [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), true, 'Falha de rede na API'],
  [
    Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED' }),
    }),
    true,
    'Automação indisponível (serviço parado)',
  ],
  [Object.assign(new Error('request aborted'), { name: 'AbortError' }), true, 'Timeout na API'],
  [new Error('Timeout na API Claro'), true, 'Timeout na API'],
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
process.env.PROXY_ENABLED = proxyOff;
console.log('ok', cases.length, 'casos');
