import { generateUniqueMsisdnsFromPrefixes } from '../lib/generate-msisdn.mjs';

const prefixes = ['1199100', '2199200', '8599300'];
const existing = new Set(['11991001111', '11991002222']);
const got = generateUniqueMsisdnsFromPrefixes(200, { existing, prefixes });
if (got.length !== 200) throw new Error(`esperava 200, veio ${got.length}`);
if (new Set(got).size !== 200) throw new Error('repetiu na lista');
for (const n of got) {
  if (existing.has(n)) throw new Error(`repetiu existente ${n}`);
  if (!/^[1-9]\d9\d{8}$/.test(n)) throw new Error(`formato inválido ${n}`);
  if (!prefixes.includes(n.slice(0, 7))) throw new Error(`prefixo fora ${n}`);
}
console.log('ok generate-unique-prefixes');
