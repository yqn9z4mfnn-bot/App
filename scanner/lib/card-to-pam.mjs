/** Converte objeto cartão do bot para linha PAM (PAN|MES|ANO|CVV). */
export function cardToPam(card) {
  if (card?.token) {
    throw new Error('Cartão salvo não suportado na automação browser — envie cartão novo.');
  }
  const pan = String(card?.number ?? '').replace(/\D/g, '');
  if (!pan || pan.length < 13) throw new Error('Número do cartão inválido.');

  let mm;
  let yyyy;
  if (card.expirationMonth && card.expirationYear) {
    mm = String(card.expirationMonth).padStart(2, '0');
    yyyy = String(card.expirationYear);
  } else if (card.expiry) {
    const [m, y] = card.expiry.includes('/')
      ? card.expiry.split('/')
      : [card.expiry.slice(0, 2), card.expiry.slice(2)];
    mm = m.padStart(2, '0');
    yyyy = y.length === 2 ? `20${y}` : y;
  } else {
    throw new Error('Validade do cartão ausente.');
  }

  const cvv = String(card.cvv ?? '').replace(/\D/g, '');
  if (!/^\d{3,4}$/.test(cvv)) throw new Error('CVV inválido.');

  return `${pan}|${mm}|${yyyy}|${cvv}`;
}

/** Valor em centavos → reais inteiros para a UI Claro (ex.: 2000 → 20). */
export function centsToRechargeValue(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Valor de recarga inválido.');
  return String(Math.round(n / 100));
}
