import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getDebugDir() {
  const fromEnv = process.env.AUTOMATION_DEBUG_DIR || process.env.CLARO_DEBUG_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const data = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '/tmp', '.local/share');
  return path.join(data, 'linkclaro-bot', 'debug');
}

const truncate = (s, n = 280) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const safeJson = (obj, max = 1200) => {
  try {
    const s = JSON.stringify(obj, null, 0);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(obj);
  }
};

/** Resume legível de um body da gate. */
export function summarizeGateBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body)) {
    const x = body[0];
    return {
      kind: 'array',
      status: x?.status,
      nsu: x?.paymentMethod?.nsu,
      method: x?.paymentMethod?.method,
    };
  }
  const pay0 = body.payments?.[0];
  return {
    kind: 'object',
    status: body.status ?? pay0?.status,
    negativeReason: pay0?.negativeReason ?? body.negativeReason,
    standardCode: pay0?.standardCode,
    loopStatus: body.tags?.transaction?.status ?? body.tags?.status,
    loopReason: body.tags?.transaction?.reason,
  };
}

/** Últimas capturas da gate para log. */
export function summarizeGateCaptures(gateCapture, tail = 8) {
  const list = gateCapture?.captures ?? [];
  return list.slice(-tail).map((c) => ({
    at: new Date(c.ts).toISOString(),
    http: c.httpStatus,
    url: truncate(c.url, 120),
    ...summarizeGateBody(c.body),
  }));
}

/** Texto visível na página + iframes (onde sucesso/erro costuma aparecer). */
export async function collectVisibleTexts(page, maxPerFrame = 400) {
  const out = { mainUrl: page.url(), frames: [] };
  try {
    const main = await page.locator('body').innerText({ timeout: 4000 });
    out.mainText = truncate(main, maxPerFrame);
  } catch (err) {
    out.mainText = `(erro: ${err?.message || err})`;
  }

  for (const frame of page.frames()) {
    const fu = frame.url() || '';
    if (!fu || fu === 'about:blank') continue;
    try {
      const raw = await frame.evaluate(
        (limit) => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, limit),
        maxPerFrame,
      );
      out.frames.push({ url: truncate(fu, 160), text: raw || '(vazio)' });
    } catch {
      out.frames.push({ url: truncate(fu, 160), text: '(iframe inacessível — cross-origin ou vazio)' });
    }
  }
  return out;
}

/**
 * Salva PNG + JSON com estado completo quando trava/timeout.
 * Retorna caminhos salvos.
 */
export async function saveStallDebug(page, session, gateCapture, tag, extra = {}) {
  const dir = getDebugDir();
  await fs.mkdir(dir, { recursive: true });
  const msisdn = session?.accessNumber || 'unknown';
  const stamp = Date.now();
  const base = path.join(dir, `stall_${tag}_${msisdn}_${stamp}`);
  const visible = await collectVisibleTexts(page);
  const gateTail = summarizeGateCaptures(gateCapture, 12);

  const report = {
    tag,
    at: new Date().toISOString(),
    msisdn,
    sessionId: session?.id,
    step: session?.step,
    stepLabel: session?.stepLabel,
    pageUrl: page.url(),
    visible,
    gateCaptures: gateTail,
    gateCaptureCount: gateCapture?.captures?.length ?? 0,
    extra,
  };

  const jsonPath = `${base}.json`;
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  let pngPath = null;
  try {
    pngPath = `${base}.png`;
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch (err) {
    report.screenshotError = String(err?.message || err);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log(`[automation][debug] stall salvo tag=${tag} msisdn=${msisdn}`);
  console.log(`[automation][debug] json=${jsonPath}`);
  if (pngPath) console.log(`[automation][debug] png=${pngPath}`);
  console.log(`[automation][debug] url=${report.pageUrl}`);
  console.log(`[automation][debug] gate_captures=${report.gateCaptureCount} últimas=${safeJson(gateTail, 800)}`);
  console.log(`[automation][debug] main_text=${visible.mainText || '?'}`);
  for (const fr of visible.frames.slice(0, 6)) {
    console.log(`[automation][debug] frame ${fr.url} → ${fr.text}`);
  }

  return { jsonPath, pngPath, report };
}
