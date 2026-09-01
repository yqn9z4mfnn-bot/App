import { normalizeMinhaClaroWebLink } from '../lib/fetch-claro-link.mjs';

let failed = 0;
const check = (name, got, want) => {
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}\n  got:  ${got}\n  want: ${want}`);
  }
};

check(
  'controle -> minhaclaro',
  normalizeMinhaClaroWebLink(
    'https://clarorecarga.claro.com.br/controle_web/select-login?t=eyJhbG',
  ),
  'https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=eyJhbG',
);

check(
  'jwt puro',
  normalizeMinhaClaroWebLink('eyJhbGciOi.test'),
  'https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=eyJhbGciOi.test',
);

check(
  'minhaclaro intacto',
  normalizeMinhaClaroWebLink(
    'https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=abc',
  ),
  'https://clarorecarga.claro.com.br/minhaclaro_web/select-login?t=abc',
);

if (failed) process.exit(1);
console.log('ok normalize claro link');
