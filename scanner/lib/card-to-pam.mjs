/** Converte cartão do bot para pamInfo da automação (PAN|MES|ANO|CVV). */
export function cardToPamInfo(card) {
  const pan = String(card.number ?? '').replace(/\D/g, '');
  if (pan.length < 13) throw new Error('Número do cartão inválido');

  let mm;
  let yyyy;

  if (card.expirationMonth != null && card.expirationYear != null) {
    mm = String(card.expirationMonth).padStart(2, '0');
    const y = String(card.expirationYear);
    yyyy = y.length === 2 ? `20${y}` : y;
  } else if (card.expiry) {
    const [m, y] = card.expiry.includes('/')
      ? card.expiry.split('/')
      : [card.expiry.slice(0, 2), card.expiry.slice(2)];
    mm = m.padStart(2, '0');
    yyyy = y.length === 2 ? `20${y}` : y;
  } else {
    throw new Error('Validade do cartão ausente');
  }

  const cvv = String(card.cvv ?? '').replace(/\D/g, '');
  if (!/^\d{3,4}$/.test(cvv)) throw new Error('CVV inválido');

  return `${pan}|${mm}|${yyyy}|${cvv}`;
}

/** Centavos → valor inteiro usado na UI Claro (R$ 20 → "20"). */
export function rechargeValueFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Valor de recarga inválido');
  const reais = n / 100;
  if (Number.isInteger(reais)) return String(reais);
  return reais.toFixed(2).replace('.', ',');
}
