import { extractCardLinesFromText, MAX_CARD_LINES_PER_INGEST } from '../lib/card-list.mjs';

function cardLine(i) {
  const pan = String(4000000000000000 + i);
  return `${pan}|08|2030|123`;
}

let failed = 0;

const small = extractCardLinesFromText(['# comentario', cardLine(1), 'nao-e-cartao', cardLine(2)].join('\n'));
if (small.total !== 2 || small.lines.length !== 2 || small.truncated) {
  failed += 1;
  console.error('FAIL small', small);
}

const many = Array.from({ length: 3500 }, (_, i) => cardLine(i)).join('\n');
const extracted = extractCardLinesFromText(many);
if (extracted.total !== 3500 || extracted.lines.length !== 3500 || extracted.truncated) {
  failed += 1;
  console.error('FAIL 3500', { total: extracted.total, kept: extracted.lines.length, truncated: extracted.truncated });
}

const over = Array.from({ length: MAX_CARD_LINES_PER_INGEST + 25 }, (_, i) => cardLine(i)).join('\n');
const capped = extractCardLinesFromText(over);
if (
  capped.total !== MAX_CARD_LINES_PER_INGEST + 25 ||
  capped.lines.length !== MAX_CARD_LINES_PER_INGEST ||
  !capped.truncated
) {
  failed += 1;
  console.error('FAIL cap', {
    total: capped.total,
    kept: capped.lines.length,
    truncated: capped.truncated,
    max: MAX_CARD_LINES_PER_INGEST,
  });
}

const custom = extractCardLinesFromText(many, { maxLines: 500 });
if (custom.total !== 3500 || custom.lines.length !== 500 || !custom.truncated) {
  failed += 1;
  console.error('FAIL custom max', custom);
}

if (failed) {
  console.error(`${failed} falha(s)`);
  process.exit(1);
}
console.log('ok extract card lines', { max: MAX_CARD_LINES_PER_INGEST });
