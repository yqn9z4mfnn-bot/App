import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCardListAction } from '../lib/card-outcome.mjs';
import { mapAutomationPaymentStatus } from '../lib/automation-client.mjs';
import { createCardListStore } from '../lib/card-list.mjs';

function outcome(status, extra = {}) {
  return {
    result: { status, message: extra.message ?? null, gateCode: extra.gateCode ?? null },
    automation: {
      raw: {
        status: extra.rawStatus ?? null,
        gateCode: extra.gateCode ?? null,
        gateMessage: extra.gateMessage ?? extra.message ?? null,
        message: extra.message ?? null,
        gateResponse: extra.gateResponse ?? null,
        pagamentoErro: extra.pagamentoErro ?? false,
      },
    },
  };
}

const cases = [
  {
    name: 'PAN não abriu (outcome ERROR + captura HTTP de cards)',
    input: {
      outcome: outcome('ERROR', {
        rawStatus: 'error',
        message: 'Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).',
        pagamentoErro: true,
        gateResponse: { httpStatus: 200, url: 'https://eldorado/cards', body: { cards: [] } },
      }),
    },
    expected: 'return',
  },
  {
    name: 'PAN não abriu (throw)',
    input: { error: new Error('Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).') },
    expected: 'return',
  },
  {
    name: 'proxy / fetch failed',
    input: { error: new Error('fetch failed') },
    expected: 'return',
  },
  {
    name: 'timeout playwright',
    input: { error: new Error('page.goto: Timeout 30000ms exceeded') },
    expected: 'return',
  },
  {
    name: 'TIMEOUT mapeado',
    input: { outcome: outcome('TIMEOUT', { rawStatus: 'timeout', message: 'Timeout aguardando SSE HTTP' }) },
    expected: 'return',
  },
  {
    name: 'AUTOMATION_FAIL',
    input: { outcome: outcome('AUTOMATION_FAIL', { message: 'error_manual' }) },
    expected: 'return',
  },
  {
    name: 'erro desconhecido (não é gate) devolve',
    input: { error: new Error('ECONNRESET') },
    expected: 'return',
  },
  {
    name: 'throw com texto de gate ainda é erro → devolve',
    input: { error: new Error('CREDIT_CARD - 422 - suspected fraud') },
    expected: 'return',
  },
  {
    name: 'ERROR de processo (checkout) devolve',
    input: {
      outcome: outcome('ERROR', {
        rawStatus: 'error',
        message: 'Não foi possível concluir o pagamento',
        pagamentoErro: true,
      }),
    },
    expected: 'return',
  },
  {
    name: 'INVALID_STATE / field value devolve',
    input: {
      outcome: outcome('AUTOMATION_FAIL', {
        gateCode: 'INVALID_STATE',
        message: 'Request cannot be executed due to incorrect field value.',
      }),
    },
    expected: 'return',
  },
  {
    name: 'DENIED real',
    input: {
      outcome: outcome('DENIED', {
        rawStatus: 'error',
        gateCode: 'DENIED',
        message: 'Transação negada',
        gateResponse: { url: '/payments', body: { status: 'DENIED', payments: [{ status: 'DENIED' }] } },
      }),
    },
    expected: 'consumed',
  },
  {
    name: 'fraude da gate',
    input: {
      outcome: outcome('DENIED', {
        gateCode: 'DENIED',
        message: 'CREDIT_CARD - 422 - suspected fraud',
        gateResponse: { httpStatus: 422, body: { status: 'DENIED' } },
      }),
    },
    expected: 'consumed',
  },
  {
    name: 'saldo insuficiente',
    input: { outcome: outcome('DENIED', { message: 'Saldo insuficiente' }) },
    expected: 'consumed',
  },
  {
    name: '3DS consome',
    input: { outcome: outcome('3DS_REQUIRED', { rawStatus: '3ds_required' }) },
    expected: 'consumed',
  },
  {
    name: '3DS + checkout/success é aprovado',
    input: {
      outcome: {
        result: { status: '3DS_REQUIRED', message: '3DS frictionless — aguardando confirmação automática' },
        automation: {
          raw: {
            status: '3ds_required',
            url: 'https://eldorado.m4u.com.br/bsc/checkout/success?code=452efbfd-378d-4893-b50d-fdca3b9bf7db',
            gateMessage: '3DS frictionless — aguardando confirmação automática',
          },
        },
      },
    },
    expected: 'approved',
  },
  {
    name: 'aprovado',
    input: { outcome: outcome('CONFIRMED', { rawStatus: 'success' }) },
    expected: 'approved',
  },
  {
    name: 'DENIED mapeado por engano (PAN + captura cards) devolve',
    input: {
      outcome: outcome('DENIED', {
        rawStatus: 'error',
        message: 'Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).',
        pagamentoErro: true,
        gateResponse: { httpStatus: 200, body: { cards: [] } },
      }),
    },
    expected: 'return',
  },
];

const mapCases = [
  {
    name: 'map PAN + pagamentoErro + gateResponse cards',
    pr: {
      status: 'error',
      gateMessage: 'Formulário PAN não abriu — checkout pode estar em cartão salvo (CVV só).',
      pagamentoErro: true,
      gateResponse: { httpStatus: 200, body: { cards: [] } },
    },
    expected: 'AUTOMATION_FAIL',
  },
  {
    name: 'map DENIED real',
    pr: {
      status: 'error',
      gateCode: 'DENIED',
      gateMessage: 'Transação negada',
      pagamentoErro: true,
      gateResponse: { body: { status: 'DENIED' } },
    },
    expected: 'DENIED',
  },
  {
    name: 'map fraude',
    pr: {
      status: 'error',
      gateMessage: 'CREDIT_CARD - 422 - suspected fraud',
      pagamentoErro: true,
      gateResponse: { httpStatus: 422, body: { status: 'DENIED' } },
    },
    expected: 'DENIED',
  },
  {
    name: 'map checkout/error não é 3DS',
    pr: {
      status: '3ds_required',
      gateCode: '3DS',
      gateMessage: '3DS frictionless — aguardando confirmação automática',
      url: 'https://eldorado.m4u.com.br/bsc/checkout/error?code=abc',
    },
    expected: 'DENIED',
  },
  {
    name: 'map timeout',
    pr: { status: 'timeout', gateMessage: 'Timeout aguardando SSE HTTP', pagamentoErro: true },
    expected: 'TIMEOUT',
  },
  {
    name: 'map pagamentoErro sozinho não é gate',
    pr: { status: 'error', message: 'algo quebrou', pagamentoErro: true, gateResponse: { httpStatus: 200 } },
    expected: 'AUTOMATION_FAIL',
  },
];

let failed = 0;

for (const c of cases) {
  const got = classifyCardListAction(c.input);
  if (got !== c.expected) {
    failed += 1;
    console.error('FAIL classify', c.name, { expected: c.expected, got });
  }
}

for (const c of mapCases) {
  const got = mapAutomationPaymentStatus(c.pr, {});
  if (got !== c.expected) {
    failed += 1;
    console.error('FAIL map', c.name, { expected: c.expected, got });
  }
}

const dir = mkdtempSync(join(tmpdir(), 'card-list-'));
try {
  const store = createCardListStore(dir);
  await store.ingestText('4111111111111111|12|2030|123\n4222222222222222|12|2030|123');
  const reserved = await store.reserveNextCard(1);
  if (!reserved?.line) throw new Error('reserva falhou');
  if (store.countPending() !== 1) throw new Error('reserva deveria deixar 1 na fila');

  const reused = await store.reserveNextCard(1);
  if (!reused?.reused || reused.pan !== reserved.pan) {
    failed += 1;
    console.error('FAIL reserve reutiliza o mesmo chat', reused);
  } else if (store.countPending() !== 1) {
    failed += 1;
    console.error('FAIL reuse queimou outro cartão', store.countPending());
  }

  const other = await store.reserveNextCard(2);
  if (!other?.pan || other.pan === reserved.pan) {
    failed += 1;
    console.error('FAIL outro chat deveria pegar o segundo', other);
  }

  const released = await store.releaseAllReservations();
  if (released.released !== 2 || store.countPending() !== 2 || store.countInUse() !== 0) {
    failed += 1;
    console.error('FAIL releaseAllReservations', released, store.countPending(), store.countInUse());
  }

  const again = await store.reserveNextCard(1);
  await store.releaseChatReservations(1);
  if (store.countInUse() !== 0 || store.countPending() !== 2) {
    failed += 1;
    console.error('FAIL releaseChatReservations', store.countPending(), store.countInUse(), again);
  }

  const reserved2 = await store.reserveNextCard(1);
  const applied = await store.applyOutcome(reserved2.line, 'return', '', 1);
  if (!applied.returned) {
    failed += 1;
    console.error('FAIL applyOutcome return', applied);
  } else if (store.countPending() !== 2) {
    failed += 1;
    console.error('FAIL fila após return', store.countPending());
  }
} catch (err) {
  failed += 1;
  console.error('FAIL applyOutcome', err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok', cases.length, 'classify ·', mapCases.length, 'map · applyOutcome');
