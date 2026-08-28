function formatBRL(cents) {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function maskCard(card) {
  return {
    brand: card.brand,
    bin: card.bin,
    last: card.last ?? card.lastDigits,
    expiration: `${String(card.expirationMonth).padStart(2, '0')}/${card.expirationYear}`,
    token: card.token ? `${String(card.token).slice(0, 8)}…` : undefined,
    holder: card.holder?.name || card.holder || '',
    type: card.type,
  };
}

export function buildSummary({ session, claro, wallet, skipWallet = false }) {
  const msisdn = session.identifier;
  const customer = claro.customer?.body;
  const products = claro.products?.body?.rechargeValues ?? [];
  const paymentMethods = claro.paymentMethods?.body ?? [];
  const recharges = claro.recharges?.body ?? [];
  const recurring = claro.rechargesRecurring?.body ?? [];
  const scheduled = claro.scheduledRecharges?.body ?? [];

  const claroCreditCards =
    paymentMethods.find((m) => m.type === 'credit')?.elements ?? [];

  let walletCards = [];
  if (wallet?.walletCards?.ok && Array.isArray(wallet.walletCards.body)) {
    walletCards = wallet.walletCards.body;
  }

  const walletTokens = new Set(walletCards.map((c) => c.token).filter(Boolean));
  const claroOnly = claroCreditCards.filter((c) => !walletTokens.has(c.token));

  const availableValues = products
    .filter((p) => p.isAvailable === true)
    .map((p) => ({
      id: p.id,
      name: p.name,
      value: p.value,
      valueFormatted: formatBRL(p.value),
      category: p.category,
      validityDays: p.custom_attributes?.reload_validity,
    }));

  const history = [...(Array.isArray(recharges) ? recharges : []), ...(Array.isArray(recurring) ? recurring : [])]
    .filter((item, idx, arr) => {
      const id = item.id ?? item.partnerExternalId;
      return arr.findIndex((x) => (x.id ?? x.partnerExternalId) === id) === idx;
    })
    .map((r) => ({
      id: r.id,
      status: r.status,
      value: r.rechargeValue?.value ?? r.value,
      valueFormatted: r.rechargeValue?.value ? formatBRL(r.rechargeValue.value) : undefined,
      date: r.createdAt ?? r.date ?? r.registerDate,
      paymentType: r.paymentMethod?.source?.type ?? r.paymentMethod?.type,
      targetMsisdn: r.targetMsisdn ?? r.msisdn,
      cardLast: r.paymentMethod?.source?.params?.last,
      cardBrand: r.paymentMethod?.source?.params?.brand,
    }));

  return {
    scannedAt: new Date().toISOString(),
    numero: msisdn,
    segmento: session.segment,
    cliente: {
      id: customer?.id,
      status: customer?.status,
      carrierSegment: customer?.carrierSegment,
      registerDate: customer?.registerDate,
      registerOrigin: customer?.registerOrigin,
      profile: customer?.profile,
      recipients: customer?.recipients,
    },
    valoresDisponiveis: availableValues,
    todosValores: products.map((p) => ({
      name: p.name,
      value: p.value,
      available: p.isAvailable === true,
      category: p.category,
    })),
    cartoes: {
      claroApi: claroOnly.map(maskCard),
      walletEldorado: walletCards.map(maskCard),
      total: walletCards.length + claroOnly.length,
      nota:
        walletCards.length > 0
          ? 'Cartões salvos ficam na wallet Eldorado (não aparecem em /payment-methods)'
          : claroCreditCards.length === 0
            ? 'Nenhum cartão vinculado encontrado'
            : undefined,
    },
    historico: {
      recargas: history,
      programadas: scheduled,
      total: history.length,
    },
    walletScan: skipWallet
      ? { ok: null, skipped: true }
      : wallet?.error
        ? { ok: false, error: wallet.error, message: wallet.message }
        : { ok: true, checkoutCode: wallet?.checkoutCode },
  };
}

export function printSummary(summary) {
  const lines = [
    '',
    '══════════════════════════════════════════',
    '  CLARO RECARGA — VARREDURA',
    '══════════════════════════════════════════',
    `Número:     ${summary.numero}`,
    `Segmento:   ${summary.segmento}`,
    `Status:     ${summary.cliente?.status ?? '—'}`,
    `Perfil:     ${summary.cliente?.profile?.name ?? '—'}`,
    '',
    `Valores disponíveis (${summary.valoresDisponiveis.length}):`,
    ...summary.valoresDisponiveis.map(
      (v) => `  • ${v.name} (${v.category}) — validade ${v.validityDays ?? '?'} dias`,
    ),
    '',
    `Cartões vinculados (${summary.cartoes.total}):`,
  ];

  for (const c of summary.cartoes.walletEldorado) {
    lines.push(`  • [wallet] ${c.brand} ${c.bin}****${c.last} exp ${c.expiration}`);
  }
  for (const c of summary.cartoes.claroApi) {
    lines.push(`  • [claro]  ${c.brand ?? ''} ****${c.last ?? '????'}`);
  }
  if (summary.cartoes.total === 0) {
    lines.push('  (nenhum)');
  }
  if (summary.cartoes.nota) {
    lines.push(`  ↳ ${summary.cartoes.nota}`);
  }

  lines.push('', `Histórico de recargas (${summary.historico.total}):`);
  if (summary.historico.total === 0) {
    lines.push('  (vazio)');
  } else {
    for (const h of summary.historico.recargas.slice(0, 10)) {
      lines.push(
        `  • ${h.status ?? '?'} — ${h.valueFormatted ?? h.value ?? '?'} — ${h.paymentType ?? '?'} ${h.date ? `(${h.date})` : ''}`,
      );
    }
    if (summary.historico.total > 10) {
      lines.push(`  … +${summary.historico.total - 10} registros`);
    }
  }

  if (summary.walletScan && !summary.walletScan.ok) {
    lines.push('', `⚠ Wallet: ${summary.walletScan.message}`);
  }

  lines.push('══════════════════════════════════════════', '');
  console.log(lines.join('\n'));
}
