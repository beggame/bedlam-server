// ============================================================================
// BEDLAM Godot — mağaza uçları (Faz 7; godot/PLAN.md §7b). server.js: require('./g_magaza').kur(app)
//
// POST /g/satin   (protokol v1)  Play satın alma doğrulaması
//   istek : { v:1, paket, urun, jeton, uid? }
//   yanıt : { v:1, ok, durum, urun, hak?, tur, test, siparis? }
//           durum: gecerli | bekliyor | iptal | gecersiz | gercek_kapali | dogrulayici_yok | hata
//   Bilinmeyen sürüm → 400 { v:1, ok:false, durum:'surum', destek:[1] }.
//
// Ürün kataloğu: urunler.json (godot/veri/urunler.json'ın kopyası; test_satin.js ikisinin aynı olduğunu denetler).
// Ortam değişkenleri:
//   PLAY_SERVIS_JSON  Google Cloud servis hesabı JSON anahtarı (Play Console › API erişimi'nde yetkili). Yoksa doğrulama yapılamaz.
//   GERCEK_SATIN=1    gerçek (test olmayan) satın almaları kabul et. VARSAYILAN KAPALI: şimdilik yalnız lisans test hesabı / test kartı.
//   SAHTE_SATIN=1     YALNIZ YEREL GELİŞTİRME: "sahte:" ile başlayan jetonlar geçerli test satın alması sayılır (PC uçtan uca testi).
//                     Render'da ASLA açılmaz.
// ============================================================================
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SURUMLER = [1];
const KATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'urunler.json'), 'utf8'));
const URUN = new Map(KATALOG.urunler.map(u => [u.id, u]));

// ---- Google Play Developer API (servis hesabı → OAuth2 erişim jetonu, RS256 JWT; ek bağımlılık yok) ----
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let erisim = null; // { jeton, bitis }
async function erisimJetonu() {
  if (erisim && erisim.bitis > Date.now() + 60000) return erisim.jeton;
  const sa = JSON.parse(process.env.PLAY_SERVIS_JSON);
  const simdi = Math.floor(Date.now() / 1000);
  const bas = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iddia = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: simdi, exp: simdi + 3600 }));
  const imza = b64url(crypto.createSign('RSA-SHA256').update(bas + '.' + iddia).sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + bas + '.' + iddia + '.' + imza });
  if (!r.ok) throw new Error('oauth ' + r.status);
  const j = await r.json(); erisim = { jeton: j.access_token, bitis: Date.now() + (j.expires_in || 3600) * 1000 }; return erisim.jeton;
}
/** purchases.products.get → { purchaseState 0 alındı / 1 iptal / 2 bekliyor, purchaseType 0 = test, orderId, acknowledgementState, consumptionState } ya da { yok:true } */
async function playDogrula(paket, urun, jeton) {
  if (process.env.SAHTE_SATIN === '1' && jeton.startsWith('sahte:')) return { purchaseState: 0, purchaseType: 0, orderId: 'SAHTE.' + jeton.slice(6, 14), acknowledgementState: 0, consumptionState: 0 };
  if (!process.env.PLAY_SERVIS_JSON) return { dogrulayiciYok: true };
  const t = await erisimJetonu();
  const r = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(paket)}/purchases/products/${encodeURIComponent(urun)}/tokens/${encodeURIComponent(jeton)}`, { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 404 || r.status === 400 || r.status === 410) return { yok: true };
  if (!r.ok) throw new Error('play ' + r.status);
  return r.json();
}

// ---- basit hız sınırı (IP başına dakikada 30) ----
const sayac = new Map();
function hizAsildi(ip) {
  const d = Math.floor(Date.now() / 60000), k = ip + '|' + d, n = (sayac.get(k) || 0) + 1; sayac.set(k, n);
  if (sayac.size > 5000) for (const key of sayac.keys()) if (!key.endsWith('|' + d)) sayac.delete(key);
  return n > 30;
}

const istat = { satin: 0, gecerli: 0, red: 0 };

function kur(app, secenek = {}) {
  const dogrula = secenek.dogrula || playDogrula;   // test: sahte doğrulayıcı
  app.use('/g/satin', express.json({ limit: '8kb' }));
  app.post('/g/satin', async (req, res) => {
    res.set('Cache-Control', 'no-store'); istat.satin++;
    const d = req.body || {};
    const yanit = (kod, o) => { if (!o.ok) istat.red++; res.status(kod).json({ v: 1, ...o }); };
    if (!SURUMLER.includes(d.v)) return yanit(400, { ok: false, durum: 'surum', destek: SURUMLER });
    if (hizAsildi(req.ip || '')) return yanit(429, { ok: false, durum: 'hata', hata: 'hiz' });
    const u = URUN.get(d.urun);
    if (!u || typeof d.jeton !== 'string' || d.jeton.length < 8 || d.jeton.length > 4096 || !KATALOG.paket.includes(d.paket)) return yanit(400, { ok: false, durum: 'gecersiz', urun: d.urun });
    let p;
    try { p = await dogrula(d.paket, d.urun, d.jeton); }
    catch (e) { console.log('[satin] dogrulama hatasi', e.message); return yanit(502, { ok: false, durum: 'hata', urun: u.id }); }
    if (p.dogrulayiciYok) return yanit(503, { ok: false, durum: 'dogrulayici_yok', urun: u.id });
    if (p.yok) return yanit(200, { ok: false, durum: 'gecersiz', urun: u.id });
    const test = p.purchaseType === 0;
    const temel = { urun: u.id, tur: u.tur, test, siparis: p.orderId || '' };
    if (!test && process.env.GERCEK_SATIN !== '1') return yanit(200, { ok: false, durum: 'gercek_kapali', ...temel });
    if (p.purchaseState === 2) return yanit(200, { ok: false, durum: 'bekliyor', ...temel });
    if (p.purchaseState !== 0) return yanit(200, { ok: false, durum: 'iptal', ...temel });
    if (u.tur === 'tuketilir' && p.consumptionState === 1) return yanit(200, { ok: false, durum: 'gecersiz', ...temel });   // zaten tüketilmiş (7.7: cüzdan tekrar yüklemeyi ayrıca reddeder)
    istat.gecerli++;
    console.log(`[satin] ${u.id} gecerli${test ? ' (test)' : ''} ${String(d.uid || '').slice(0, 8)}`);
    return yanit(200, { ok: true, durum: 'gecerli', hak: u.hak || null, ...temel });
  });
  return { istat };
}

module.exports = { kur, playDogrula, KATALOG, istat };
