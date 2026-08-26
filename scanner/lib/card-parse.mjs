const FIRST = [
  'JOAO', 'MARIA', 'PEDRO', 'ANA', 'LUCAS', 'JULIA', 'CARLOS', 'FERNANDA',
  'RAFAEL', 'BEATRIZ', 'GUSTAVO', 'CAMILA', 'BRUNO', 'LARISSA', 'FELIPE', 'AMANDA',
  'RODRIGO', 'PATRICIA', 'MARCOS', 'ALINE', 'RENATO', 'VANESSA', 'TIAGO', 'CLAUDIA',
];

const LAST = [
  'SILVA', 'SANTOS', 'OLIVEIRA', 'SOUZA', 'LIMA', 'COSTA', 'FERREIRA', 'RODRIGUES',
  'ALMEIDA', 'NASCIMENTO', 'PEREIRA', 'CARVALHO', 'GOMES', 'RIBEIRO', 'MARTINS', 'ARAUJO',
  'MELO', 'BARBOSA', 'ROCHA', 'DIAS', 'CAVALCANTI', 'MONTEIRO', 'CARDOSO', 'TEIXEIRA',
];

export function randomHolderName() {
  const f = FIRST[Math.floor(Math.random() * FIRST.length)];
  const l = LAST[Math.floor(Math.random() * LAST.length)];
  return `${f} ${l}`.toUpperCase();
}

function splitParts(text) {
  const raw = text.trim();
  if (/[|;]/.test(raw)) {
    return raw.split(/[|;]+/).map((p) => p.trim()).filter(Boolean);
  }
  return raw.split(/\s+/).map((p) => p.trim()).filter(Boolean);
}

function parseExpiryField(field) {
  const f = field.trim().replace(/-/g, '/');

  if (/^\d{2}\/\d{2,4}$/.test(f)) {
    const [month, year] = f.split('/');
    return { month, year };
  }
  if (/^\d{4}$/.test(f)) {
    return { month: f.slice(0, 2), year: f.slice(2) };
  }
  if (/^\d{6}$/.test(f)) {
    return { month: f.slice(0, 2), year: f.slice(2) };
  }
  if (/^\d{2}$/.test(f)) {
    return null;
  }
  return null;
}

function normalizeYear(year) {
  const y = String(year).replace(/\D/g, '');
  if (y.length === 2) return `20${y}`;
  if (y.length === 4) return y;
  return null;
}

function buildCard({ pan, month, year, cvv, holder }) {
  const yyyy = normalizeYear(year);
  const mm = String(month).padStart(2, '0');
  if (!yyyy || !/^\d{2}$/.test(mm)) return null;
  const cvvClean = String(cvv).replace(/\D/g, '');
  if (!/^\d{3,4}$/.test(cvvClean)) return null;

  return {
    number: pan,
    holder: (holder ?? randomHolderName()).toUpperCase(),
    expiry: `${mm}/${yyyy.slice(-2)}`,
    cvv: cvvClean,
    expirationMonth: Number(mm),
    expirationYear: Number(yyyy),
  };
}

/**
 * Aceita formatos flexíveis, ex.:
 * - 4271680002723941|08|2033|999
 * - 4271680002723941|08|33|999
 * - 4271680002723941|08/2033|999
 * - 4271680002723941 08 2033 999
 * - 4271680002723941|NOME SOBRENOME|08/33|999 (nome opcional)
 */
export function parseCardInput(text) {
  const parts = splitParts(text);
  if (parts.length < 3) return null;

  const pan = parts[0].replace(/\D/g, '');
  if (pan.length < 13 || pan.length > 19) return null;

  // PAN | MM | YYYY | CVV  ou  PAN | MM | YY | CVV
  if (parts.length === 4 && /^\d{2}$/.test(parts[1]) && /^\d{2,4}$/.test(parts[2])) {
    return buildCard({
      pan,
      month: parts[1],
      year: parts[2],
      cvv: parts[3],
    });
  }

  // PAN | NOME | EXPIRY | CVV
  if (parts.length === 4 && !/^\d{2}$/.test(parts[1])) {
    const exp = parseExpiryField(parts[2]);
    if (!exp) return null;
    return buildCard({
      pan,
      month: exp.month,
      year: exp.year,
      cvv: parts[3],
      holder: parts[1],
    });
  }

  // PAN | EXPIRY | CVV
  if (parts.length === 3) {
    const exp = parseExpiryField(parts[1]);
    if (!exp) return null;
    return buildCard({
      pan,
      month: exp.month,
      year: exp.year,
      cvv: parts[2],
    });
  }

  return null;
}

export const CARD_INPUT_HINT =
  'Envie o cartão em uma linha:\n<code>NUMERO|MM|AAAA|CVV</code>\n\nEx: <code>4271680002723941|08|2033|999</code>\n<i>Nome gerado automaticamente.</i>';
